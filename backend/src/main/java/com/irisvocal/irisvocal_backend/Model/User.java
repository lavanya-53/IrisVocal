package com.irisvocal.irisvocal_backend.Model;




import jakarta.persistence.*;
import lombok.*;
import lombok.NoArgsConstructor;


@Entity
@Table(name = "users")
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false, unique = true)
    private String email;

    @Column(nullable = false)
    private String passwordHash;

    private String emergencyContactName;

    private String emergencyContactNumber;
    @Column(name = "emergency_contact_email")
    private String emergencyContactEmail;
}

